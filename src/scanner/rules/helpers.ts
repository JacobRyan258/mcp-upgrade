import type {
  Confidence,
  Finding,
  FindingLevel,
  PreparedFile,
  ScanContext,
  ScannerRule,
} from '../../types.js';
import { isInComment, lineText, offsetToPosition } from '../discovery.js';
import { toEvidence } from '../redaction.js';

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

  while ((match = scoped.exec(file.content)) !== null) {
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
  }
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
  const endLine = hit.endOffset ? offsetToPosition(hit.file, hit.endOffset).line : line;
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
    evidence: toEvidence(rawEvidence),
    explanation: input.explanation,
    remediation: input.remediation,
    source: rule.source,
    autofix: rule.autofix,
  };

  if (endLine !== line) finding.endLine = endLine;
  if (input.transportApplicability) finding.transportApplicability = input.transportApplicability;
  return finding;
}

/**
 * The source line as evidence — windowed around the match when the line is
 * longer than an excerpt can show, so the matched token is always visible
 * (minified files are single multi-kilobyte lines; the head of one says
 * nothing).
 */
function evidenceLine(hit: Hit, line: number, column: number): string {
  const text = lineText(hit.file, line) || hit.text;
  if (text.length <= 200) return text;
  const start = Math.max(0, column - 1 - 80);
  return `${start > 0 ? '…' : ''}${text.slice(start, start + 240)}`;
}

/**
 * Keeps at most one finding per rule per source line.
 *
 * A rule commonly matches the same line through several routes — an AST pass
 * and a lexical fallback, or two nested capability paths in one object literal.
 * Reporting that line once keeps the report readable and the score honest,
 * without hiding any distinct location. The most severe, then most confident,
 * candidate for a line wins.
 */
export function dedupeByLocation(findings: Finding[]): Finding[] {
  const byLine = new Map<string, Finding>();

  for (const finding of findings) {
    const key = `${finding.ruleId} ${finding.file} ${finding.line}`;
    const incumbent = byLine.get(key);
    if (!incumbent || outranks(finding, incumbent)) byLine.set(key, finding);
  }

  return [...byLine.values()];
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
const MCP_FILE_SIGNAL =
  /@modelcontextprotocol|modelcontextprotocol\.io|\bMcpServer\b|\bFastMCP\b|\bmcp\b|json-?rpc/i;

export function fileHasMcpSignal(file: PreparedFile): boolean {
  return MCP_FILE_SIGNAL.test(file.content);
}

/** The repository shows MCP evidence, or this specific file does. */
export function inMcpContext(context: ScanContext, file: PreparedFile): boolean {
  return context.repository.isLikelyMcpServer || fileHasMcpSignal(file);
}
