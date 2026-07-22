import ts from 'typescript';
import type { FileKind, PreparedFile, Range } from '../types.js';

/**
 * Targeted TypeScript AST support.
 *
 * The compiler API is used only where it removes false positives that a regex
 * cannot: telling a comment from code, telling an error code that is *emitted*
 * from one that is merely *compared against*, resolving nested object-property
 * paths for capability declarations, and recognising call and header-access
 * expressions. There is no program construction, no type checker and no
 * whole-program analysis — and scanned code is never executed.
 */

/* -------------------------------------------------------------------------- */
/* Line index                                                                  */
/* -------------------------------------------------------------------------- */

export function computeLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

const parseCache = new WeakMap<PreparedFile, ts.SourceFile | null>();
const contentParseCache = new Map<string, ts.SourceFile>();

function scriptKindFor(ext: string): ts.ScriptKind {
  switch (ext) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    case '.json':
      return ts.ScriptKind.JSON;
    default:
      return ts.ScriptKind.TS;
  }
}

function parse(content: string, ext: string): ts.SourceFile {
  const key = `${ext} ${content}`;
  const cached = contentParseCache.get(key);
  if (cached) return cached;
  const sourceFile = ts.createSourceFile(
    `source${ext}`,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(ext),
  );
  // Bounded so a large scan cannot grow this without limit.
  if (contentParseCache.size > 512) contentParseCache.clear();
  contentParseCache.set(key, sourceFile);
  return sourceFile;
}

/**
 * Returns the parsed source file for TS/JS/JSON inputs, or null for YAML.
 * JSON parses in the compiler's JSON mode, so rules that walk object-property
 * paths (capability declarations) see the same shapes in `.json` config files
 * as in source code.
 */
export function getSourceFile(file: PreparedFile): ts.SourceFile | null {
  if (parseCache.has(file)) return parseCache.get(file) ?? null;
  let result: ts.SourceFile | null = null;
  if (file.kind === 'ts' || file.kind === 'js' || file.kind === 'json') {
    try {
      result = parse(file.content, file.ext);
    } catch {
      // A file the parser cannot survive falls back to the lexical passes.
      result = null;
    }
  }
  parseCache.set(file, result);
  return result;
}

/* -------------------------------------------------------------------------- */
/* Comment ranges                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Computes the offsets covered by comments.
 *
 * TS/JS ranges come from the parser rather than a raw scanner, so a regular
 * expression literal containing `//` is not mistaken for a comment — which
 * would silently suppress a real finding on that line.
 */
export function computeCommentRanges(content: string, kind: FileKind, ext: string): Range[] {
  switch (kind) {
    case 'ts':
    case 'js':
      return commentRangesFromParse(content, ext);
    case 'json':
      return lexCommentsJsonc(content);
    case 'yaml':
      return lexCommentsYaml(content);
    default:
      return [];
  }
}

function commentRangesFromParse(content: string, ext: string): Range[] {
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = parse(content, ext);
  } catch {
    return [];
  }

  const seen = new Set<number>();
  const ranges: Range[] = [];

  const collect = (found: readonly ts.CommentRange[] | undefined): void => {
    if (!found) return;
    for (const range of found) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      ranges.push({ start: range.pos, end: range.end });
    }
  };

  try {
    walk(sourceFile, (node) => {
      if (node.getFullStart() !== node.getStart(sourceFile, true)) {
        collect(ts.getLeadingCommentRanges(content, node.getFullStart()));
      }
      // Same-line trailing comments (`code(); // note`) are trailing trivia and
      // never appear in any node's leading ranges; missing them would let rules
      // fire inside comments.
      collect(ts.getTrailingCommentRanges(content, node.getEnd()));
    });
    // The final trailing comment of a file hangs off the EOF token.
    collect(ts.getLeadingCommentRanges(content, sourceFile.endOfFileToken.getFullStart()));
  } catch {
    // A pathological file must degrade (no comment suppression), never crash
    // the scan.
    return [];
  }

  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

/** JSON with comments (`//`, `/* *\/`), string-aware. */
export function lexCommentsJsonc(content: string): Range[] {
  const ranges: Range[] = [];
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '"') {
      i = skipQuoted(content, i, '"');
      continue;
    }
    if (ch === '/' && content[i + 1] === '/') {
      const start = i;
      while (i < content.length && content[i] !== '\n') i++;
      ranges.push({ start, end: i });
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i = Math.min(i + 2, content.length);
      ranges.push({ start, end: i });
      continue;
    }
    i++;
  }
  return ranges;
}

/**
 * YAML comments. A `#` only opens a comment at the start of a line or after
 * whitespace, so `url: http://example.com/#frag` is not treated as one.
 */
export function lexCommentsYaml(content: string): Range[] {
  const ranges: Range[] = [];
  let i = 0;
  let atLineStart = true;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '\n') {
      atLineStart = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      atLineStart = false;
      i = skipQuoted(content, i, ch);
      continue;
    }
    if (ch === '#') {
      const prev = i > 0 ? content[i - 1] : undefined;
      const opensComment = atLineStart || prev === ' ' || prev === '\t';
      if (opensComment) {
        const start = i;
        while (i < content.length && content[i] !== '\n') i++;
        ranges.push({ start, end: i });
        continue;
      }
    }
    if (ch !== ' ' && ch !== '\t') atLineStart = false;
    i++;
  }
  return ranges;
}

function skipQuoted(content: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < content.length) {
    const ch = content[i];
    // YAML single-quoted strings escape by doubling; JSON/double-quoted use `\`.
    if (ch === '\\' && quote === '"') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (quote === "'" && content[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    if (ch === '\n' && quote === "'") return i;
    i++;
  }
  return i;
}

/* -------------------------------------------------------------------------- */
/* Node queries                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Depth-first pre-order walk over every node.
 *
 * Iterative on purpose: scanned code is hostile input, and a minified file can
 * contain expression chains hundreds of thousands of nodes deep — a recursive
 * walk overflows the call stack on exactly the files a scanner most needs to
 * survive. `ts.forEachChild` only descends one level per call, so stack depth
 * stays constant regardless of AST depth.
 */
export function walk(node: ts.Node, visitor: (node: ts.Node) => void): void {
  const stack: ts.Node[] = [node];
  const children: ts.Node[] = [];
  while (stack.length > 0) {
    const current = stack.pop() as ts.Node;
    visitor(current);
    children.length = 0;
    ts.forEachChild(current, (child) => {
      children.push(child);
    });
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as ts.Node);
  }
}

/**
 * True when `offset` sits inside a template literal that spans more than one
 * line. Multi-line template strings are overwhelmingly documentation, SQL,
 * prose or generated text rather than protocol code, so rules that match
 * quoted protocol literals downgrade rather than assert an ERROR there.
 */
export function isInsideMultilineTemplate(
  sourceFile: ts.SourceFile,
  content: string,
  offset: number,
): boolean {
  // Iterative descent along the containment path; recursion would overflow on
  // pathologically deep ASTs.
  let current: ts.Node | undefined = sourceFile;
  while (current) {
    if (ts.isTemplateLiteral(current)) {
      const text = content.slice(current.getStart(sourceFile, false), current.getEnd());
      if (text.includes('\n')) return true;
    }
    let next: ts.Node | undefined;
    ts.forEachChild(current, (child) => {
      if (next) return;
      if (offset >= child.getStart(sourceFile, true) && offset < child.getEnd()) next = child;
    });
    current = next;
  }
  return false;
}

/** Finds the innermost node containing `offset`. */
export function nodeAt(sourceFile: ts.SourceFile, offset: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  let current: ts.Node | undefined = sourceFile;
  while (current) {
    let next: ts.Node | undefined;
    ts.forEachChild(current, (child) => {
      if (next) return;
      if (offset >= child.getStart(sourceFile, true) && offset < child.getEnd()) next = child;
    });
    if (next) found = next;
    current = next;
  }
  return found;
}

/** Renders a dotted callee name, e.g. `server.setRequestHandler`. */
export function calleeName(node: ts.CallExpression | ts.NewExpression): string {
  return expressionText(node.expression);
}

function expressionText(node: ts.Expression, depth = 0): string {
  // Bounded: hostile minified code can nest access chains deep enough to
  // overflow a recursive renderer, and nothing meaningful lives past this.
  if (depth > 64) return '';
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    return `${expressionText(node.expression, depth + 1)}.${node.name.text}`;
  }
  if (ts.isElementAccessExpression(node)) {
    const arg = node.argumentExpression;
    const key = ts.isStringLiteralLike(arg) ? arg.text : '?';
    return `${expressionText(node.expression, depth + 1)}[${key}]`;
  }
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isCallExpression(node)) return `${expressionText(node.expression, depth + 1)}()`;
  if (ts.isParenthesizedExpression(node)) return expressionText(node.expression, depth + 1);
  if (ts.isNonNullExpression(node)) return expressionText(node.expression, depth + 1);
  return '';
}

/** The literal text of a property name, or null for computed names. */
export function propertyKeyText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return null;
}

/**
 * Builds the dotted object-literal path of a node, outermost first, e.g. a node
 * inside `{ capabilities: { tasks: { list: {} } } }` yields
 * `capabilities.tasks.list`. Used for capability declarations, where the
 * meaningful signal is the nesting rather than any single key.
 */
export function objectPropertyPath(node: ts.Node): string {
  const parts: string[] = [];
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isPropertyAssignment(current) || ts.isShorthandPropertyAssignment(current)) {
      const key = ts.isShorthandPropertyAssignment(current)
        ? current.name.text
        : propertyKeyText(current.name);
      if (key) parts.push(key);
    }
    current = current.parent;
  }
  return parts.reverse().join('.');
}

/** Every property-assignment path in a file, with the assignment's offsets. */
export interface PropertyPathHit {
  path: string;
  key: string;
  node: ts.PropertyAssignment | ts.ShorthandPropertyAssignment;
  start: number;
  end: number;
}

export function collectPropertyPaths(sourceFile: ts.SourceFile): PropertyPathHit[] {
  const hits: PropertyPathHit[] = [];
  walk(sourceFile, (node) => {
    if (!ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) return;
    const key = ts.isShorthandPropertyAssignment(node)
      ? node.name.text
      : propertyKeyText(node.name);
    if (!key) return;
    hits.push({
      path: objectPropertyPath(node),
      key,
      node,
      start: node.getStart(sourceFile, false),
      end: node.getEnd(),
    });
  });
  return hits;
}

/* -------------------------------------------------------------------------- */
/* Error-code usage                                                            */
/* -------------------------------------------------------------------------- */

export type CodeUsage = 'emit' | 'compare' | 'declare' | 'list' | 'unknown';

const EMIT_CALL_PATTERN =
  /(^|\.)(McpError|ProtocolError|JsonRpcError|RpcError|sendError|createError|makeError|jsonRpcError|errorResponse|reject|fail|throwError|json|send|reply|respond)$/i;

const COMPARE_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

/**
 * Classifies how a numeric error-code literal is used.
 *
 * This is the distinction that decides whether a `-32002` is a spec violation
 * or correct forward-compatible client code: servers MUST NOT *emit* `-32002`
 * for a missing resource, but clients SHOULD still *accept* it from older
 * servers, so a comparison is not a finding.
 */
export function classifyCodeUsage(node: ts.Node): CodeUsage {
  let current: ts.Node | undefined = node;
  let depth = 0;

  while (current && depth < 12) {
    const parent: ts.Node | undefined = current.parent;
    if (!parent) break;

    if (ts.isBinaryExpression(parent) && COMPARE_OPERATORS.has(parent.operatorToken.kind)) {
      return 'compare';
    }
    if (ts.isCaseClause(parent)) return 'compare';
    if (ts.isSwitchStatement(parent) && parent.expression === current) return 'compare';
    // A literal inside an array is list membership — most often an acceptance
    // list such as `const NOT_FOUND = [-32002, -32602]`, which is correct
    // client behaviour and must never be asserted as an emission.
    if (ts.isArrayLiteralExpression(parent)) return 'list';
    if (ts.isCallExpression(parent)) {
      const name = calleeName(parent);
      if (/(^|\.)(includes|has|indexOf|some|contains)$/.test(name)) return 'compare';
      if (EMIT_CALL_PATTERN.test(name)) return 'emit';
    }
    if (ts.isNewExpression(parent) && EMIT_CALL_PATTERN.test(calleeName(parent))) {
      return 'emit';
    }
    if (ts.isThrowStatement(parent)) return 'emit';
    if (ts.isReturnStatement(parent)) return 'emit';

    if (ts.isVariableDeclaration(parent) || ts.isEnumMember(parent)) return 'declare';

    current = parent;
    depth++;
  }

  return 'unknown';
}

/** Numeric literal hits, including negated forms such as `-32002`. */
export interface NumericHit {
  value: number;
  node: ts.Node;
  start: number;
  end: number;
  usage: CodeUsage;
}

export function collectNumericLiterals(sourceFile: ts.SourceFile, target: number): NumericHit[] {
  const hits: NumericHit[] = [];
  walk(sourceFile, (node) => {
    if (!ts.isNumericLiteral(node)) return;
    const raw = Number(node.text);
    if (Number.isNaN(raw)) return;

    const parent = node.parent;
    const negated =
      parent &&
      ts.isPrefixUnaryExpression(parent) &&
      parent.operator === ts.SyntaxKind.MinusToken &&
      parent.operand === node;
    const value = negated ? -raw : raw;
    if (value !== target) return;

    const anchor = negated ? parent : node;
    hits.push({
      value,
      node: anchor,
      start: anchor.getStart(sourceFile, false),
      end: anchor.getEnd(),
      usage: classifyCodeUsage(anchor),
    });
  });
  return hits;
}

/* -------------------------------------------------------------------------- */
/* Call and header access                                                      */
/* -------------------------------------------------------------------------- */

export interface CallHit {
  name: string;
  node: ts.CallExpression;
  start: number;
  end: number;
  /** Text of string-literal arguments, in order; non-literals become null. */
  stringArgs: (string | null)[];
}

export function collectCalls(sourceFile: ts.SourceFile): CallHit[] {
  const hits: CallHit[] = [];
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    hits.push({
      name: calleeName(node),
      node,
      start: node.getStart(sourceFile, false),
      end: node.getEnd(),
      stringArgs: node.arguments.map((arg) => (ts.isStringLiteralLike(arg) ? arg.text : null)),
    });
  });
  return hits;
}

export interface HeaderAccessHit {
  /** Lower-cased header name. */
  header: string;
  /** `read` for lookups, `write` for assignments and `set`-style calls. */
  mode: 'read' | 'write';
  node: ts.Node;
  start: number;
  end: number;
}

const HEADER_WRITE_CALLS = /(^|\.)(setHeader|set|append|writeHead|header)$/;
const HEADER_READ_CALLS = /(^|\.)(get|getHeader|has)$/;

/**
 * Finds HTTP header reads and writes by name.
 *
 * Covers the shapes that actually occur in MCP servers: `req.headers['x']`,
 * `req.headers.x`, `headers.get('x')`, `res.setHeader('x', …)`,
 * `headers.set('x', …)` and object literals such as `{ 'x': value }` inside a
 * `headers:` property.
 */
export function collectHeaderAccess(
  sourceFile: ts.SourceFile,
  wanted: ReadonlySet<string>,
): HeaderAccessHit[] {
  const hits: HeaderAccessHit[] = [];
  const push = (header: string, mode: 'read' | 'write', node: ts.Node): void => {
    hits.push({
      header,
      mode,
      node,
      start: node.getStart(sourceFile, false),
      end: node.getEnd(),
    });
  };

  walk(sourceFile, (node) => {
    // headers['mcp-session-id'] / headers.mcpSessionId is not a header name, so
    // only the string-keyed and dashed forms are considered.
    if (ts.isElementAccessExpression(node)) {
      const arg = node.argumentExpression;
      if (ts.isStringLiteralLike(arg)) {
        const name = arg.text.toLowerCase();
        if (wanted.has(name) && /header/i.test(expressionText(node.expression))) {
          const isWrite =
            node.parent &&
            ts.isBinaryExpression(node.parent) &&
            node.parent.left === node &&
            node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
          push(name, isWrite ? 'write' : 'read', node);
        }
      }
      return;
    }

    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const first = node.arguments[0];
      if (!first || !ts.isStringLiteralLike(first)) return;
      const header = first.text.toLowerCase();
      if (!wanted.has(header)) return;
      if (HEADER_WRITE_CALLS.test(name)) push(header, 'write', node);
      else if (HEADER_READ_CALLS.test(name)) push(header, 'read', node);
      return;
    }

    if (ts.isPropertyAssignment(node)) {
      const key = propertyKeyText(node.name);
      if (!key) return;
      const header = key.toLowerCase();
      if (!wanted.has(header)) return;
      // Only count it when it sits inside something header-shaped.
      const path = objectPropertyPath(node);
      if (/header/i.test(path) || isInsideHeadersArgument(node)) push(header, 'write', node);
    }
  });

  return hits;
}

function isInsideHeadersArgument(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  let depth = 0;
  while (current && depth < 6) {
    if (ts.isNewExpression(current) && calleeName(current) === 'Headers') return true;
    if (ts.isPropertyAssignment(current)) {
      const key = propertyKeyText(current.name);
      if (key && /^headers$/i.test(key)) return true;
    }
    current = current.parent;
    depth++;
  }
  return false;
}
