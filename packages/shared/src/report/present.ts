/**
 * Presentation mapping: turns a validated published report into exactly what
 * the report page renders.
 *
 * Kept here rather than in the web app so the same mapping backs the HTML page,
 * the Markdown download and the printable report — three views that must never
 * disagree about a readiness band or a finding count.
 */
import type { PlainTheme, RuleGuide } from './explain.js';
import { guideForRule, themeLabel, themeRank } from './explain.js';
import type { PublishedFinding, PublishedFindingLevel, PublishedReport } from './schema.js';

/**
 * The disclaimer that must accompany every clean or near-clean result.
 *
 * This exact wording is a product requirement, not a suggestion. It is the only
 * honest description of what a static scanner can tell you.
 */
export const CLEAN_REPORT_DISCLAIMER =
  'A clean report means that no implemented rule fired. It does not guarantee complete compatibility with the target MCP specification.';

export type ReadinessBand = 'ready' | 'needs-attention' | 'high-risk';

export interface ReadinessVerdict {
  band: ReadinessBand;
  /** Short label shown next to the score. */
  label: string;
  /** One sentence explaining the band. */
  summary: string;
}

/**
 * Bands are driven by *findings*, not by the score alone.
 *
 * A confirmed incompatibility means the server is at high migration risk even
 * if the numeric score happens to stay high because there is only one of them.
 */
export function readinessVerdict(report: PublishedReport): ReadinessVerdict {
  const counts = report.summary.counts;
  if (counts.error > 0) {
    return {
      band: 'high-risk',
      label: 'High migration risk',
      summary:
        'We found confirmed incompatibilities with the target protocol version. These need code changes before you upgrade.',
    };
  }
  if (counts.warning > 0 || counts.review > 0) {
    return {
      band: 'needs-attention',
      label: 'Needs attention',
      summary:
        'We found deprecated features or patterns that need a developer to look at them, but no confirmed incompatibilities.',
    };
  }
  return {
    band: 'ready',
    label: 'Ready',
    summary: CLEAN_REPORT_DISCLAIMER,
  };
}

export interface TopSummary {
  score: number;
  verdict: ReadinessVerdict;
  errors: number;
  warnings: number;
  reviews: number;
  infos: number;
  filesScanned: number;
  filesSkipped: number;
  filesRequiringChanges: number;
  partial: boolean;
  /** Non-empty only when the scan was partial. Plain-English, deduplicated. */
  partialReasons: string[];
  targetVersion: string;
  baselineVersion: string;
  targetIsReleaseCandidate: boolean;
  isLikelyMcpServer: boolean;
  transport: string;
  /** Total findings at or above `review`. */
  actionableFindings: number;
}

const PARTIAL_REASON_COPY: Readonly<Record<string, string>> = Object.freeze({
  'too-large': 'Some files were larger than we will read.',
  binary: 'Some files were binary and were not source code.',
  'invalid-utf8': 'Some files were not valid text.',
  'parse-failure': 'Some files could not be parsed as source code.',
  'complexity-limit': 'Some files were too complex to analyse fully.',
  unreadable: 'Some files could not be read.',
  'unreadable-directory': 'Some folders could not be read.',
  symlink: 'Links inside the project were not followed.',
  'symlink-outside-root': 'Links pointing outside the project were not followed.',
  'depth-limit': 'Some folders were nested more deeply than we will walk.',
  'discovery-limit': 'The project contains more files than we will list.',
  'scan-limit': 'The project is larger than a single scan will read.',
  'analysis-limit': 'Some checks stopped early on unusually large files.',
  'finding-limit': 'The report reached its maximum number of findings.',
  'report-limit': 'The report reached its maximum size.',
  'root-changed': 'The project changed while it was being scanned.',
});

export function summarise(report: PublishedReport): TopSummary {
  const counts = report.summary.counts;
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const issue of report.issues) {
    const copy = PARTIAL_REASON_COPY[issue.code];
    if (!copy || seen.has(copy)) continue;
    seen.add(copy);
    reasons.push(copy);
  }
  return {
    score: report.summary.readiness.score,
    verdict: readinessVerdict(report),
    errors: counts.error,
    warnings: counts.warning,
    reviews: counts.review,
    infos: counts.info,
    filesScanned: report.summary.filesScanned,
    filesSkipped: report.summary.filesSkipped,
    filesRequiringChanges: report.summary.filesRequiringChanges,
    partial: report.scanStatus === 'partial',
    partialReasons: reasons,
    targetVersion: report.target.protocolVersion,
    baselineVersion: report.target.baselineVersion,
    targetIsReleaseCandidate: report.target.status === 'release-candidate',
    isLikelyMcpServer: report.repository.isLikelyMcpServer,
    transport: transportLabel(report.repository.transport),
    actionableFindings: counts.error + counts.warning + counts.review,
  };
}

export function transportLabel(transport: string): string {
  switch (transport) {
    case 'stdio':
      return 'Local (standard input/output)';
    case 'streamable-http':
      return 'Remote (streamable HTTP)';
    case 'custom-http':
      return 'Remote (custom HTTP)';
    case 'mixed':
      return 'Both local and remote';
    default:
      return 'Not determined';
  }
}

export const LEVEL_LABELS: Readonly<Record<PublishedFindingLevel, string>> = Object.freeze({
  error: 'Will break',
  warning: 'Deprecated',
  review: 'Needs review',
  info: 'Informational',
});

export const LEVEL_DESCRIPTIONS: Readonly<Record<PublishedFindingLevel, string>> = Object.freeze({
  error: 'A confirmed incompatibility with the target protocol version.',
  warning:
    'A real migration risk. Deprecated features keep working during their deprecation window.',
  review: 'A pattern that may need changing. A person has to decide.',
  info: 'A non-breaking improvement or opportunity.',
});

export const CONFIDENCE_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  high: 'We are confident this is a genuine match.',
  medium: 'This is very likely a genuine match.',
  low: 'This may be a false match. Worth a quick look.',
});

const LEVEL_RANK: Readonly<Record<PublishedFindingLevel, number>> = Object.freeze({
  error: 0,
  warning: 1,
  review: 2,
  info: 3,
});

const CONFIDENCE_RANK: Readonly<Record<string, number>> = Object.freeze({
  high: 0,
  medium: 1,
  low: 2,
});

export interface PresentedFinding {
  finding: PublishedFinding;
  guide: RuleGuide;
  levelLabel: string;
  confidenceLabel: string;
}

export interface PresentedGroup {
  theme: PlainTheme;
  title: string;
  findings: PresentedFinding[];
  /** Highest severity present in the group. Drives the group's badge. */
  topLevel: PublishedFindingLevel;
}

/**
 * Orders findings deterministically: severity, then confidence, then rule, then
 * file, then line. Two scans of the same code always render identically.
 */
export function orderFindings(findings: readonly PublishedFinding[]): PublishedFinding[] {
  return [...findings].sort((a, b) => {
    const level = LEVEL_RANK[a.level] - LEVEL_RANK[b.level];
    if (level !== 0) return level;
    const conf = (CONFIDENCE_RANK[a.confidence] ?? 9) - (CONFIDENCE_RANK[b.confidence] ?? 9);
    if (conf !== 0) return conf;
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return (a.column ?? 0) - (b.column ?? 0);
  });
}

export function presentFinding(finding: PublishedFinding): PresentedFinding {
  return {
    finding,
    guide: guideForRule(finding.ruleId),
    levelLabel: LEVEL_LABELS[finding.level],
    confidenceLabel: CONFIDENCE_DESCRIPTIONS[finding.confidence] ?? '',
  };
}

/** Groups findings into the plain-English themes, in a fixed order. */
export function groupFindings(findings: readonly PublishedFinding[]): PresentedGroup[] {
  const buckets = new Map<PlainTheme, PresentedFinding[]>();
  for (const finding of orderFindings(findings)) {
    const presented = presentFinding(finding);
    const existing = buckets.get(presented.guide.theme);
    if (existing) existing.push(presented);
    else buckets.set(presented.guide.theme, [presented]);
  }
  const groups: PresentedGroup[] = [];
  for (const [theme, items] of buckets) {
    let topLevel: PublishedFindingLevel = 'info';
    for (const item of items) {
      if (LEVEL_RANK[item.finding.level] < LEVEL_RANK[topLevel]) topLevel = item.finding.level;
    }
    groups.push({ theme, title: themeLabel(theme), findings: items, topLevel });
  }
  groups.sort((a, b) => {
    const level = LEVEL_RANK[a.topLevel] - LEVEL_RANK[b.topLevel];
    if (level !== 0) return level;
    return themeRank(a.theme) - themeRank(b.theme);
  });
  return groups;
}

/**
 * The ordered list of things to do, most important first.
 *
 * Deduplicated by rule: a rule that fires in twenty files is one action item
 * with twenty locations, not twenty separate instructions.
 */
export interface ActionItem {
  ruleId: string;
  guide: RuleGuide;
  level: PublishedFindingLevel;
  occurrences: number;
  files: string[];
  /** The scanner's technical remediation text. */
  remediation: string;
  sourceUrl: string;
  sourceTitle: string;
}

export function actionPlan(report: PublishedReport): ActionItem[] {
  const byRule = new Map<string, ActionItem>();
  for (const finding of orderFindings(report.findings)) {
    if (finding.level === 'info') continue;
    const existing = byRule.get(finding.ruleId);
    if (existing) {
      existing.occurrences += 1;
      if (!existing.files.includes(finding.file)) existing.files.push(finding.file);
      if (LEVEL_RANK[finding.level] < LEVEL_RANK[existing.level]) existing.level = finding.level;
      continue;
    }
    byRule.set(finding.ruleId, {
      ruleId: finding.ruleId,
      guide: guideForRule(finding.ruleId),
      level: finding.level,
      occurrences: 1,
      files: [finding.file],
      remediation: finding.remediation,
      sourceUrl: finding.source.url,
      sourceTitle: finding.source.title,
    });
  }
  const items = [...byRule.values()];
  items.sort((a, b) => {
    const level = LEVEL_RANK[a.level] - LEVEL_RANK[b.level];
    if (level !== 0) return level;
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    return a.ruleId < b.ruleId ? -1 : 1;
  });
  for (const item of items) item.files.sort();
  return items;
}

/** Human-readable effort range, e.g. "4–12 hours". Null when nothing to do. */
export function effortRange(report: PublishedReport): string | null {
  const { minHours, maxHours } = report.summary.effort;
  if (minHours <= 0 && maxHours <= 0) return null;
  if (minHours === maxHours) return `about ${formatHours(minHours)}`;
  return `${formatHours(minHours)}–${formatHours(maxHours)}`;
}

function formatHours(hours: number): string {
  if (hours < 1) return 'under an hour';
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} ${rounded === 1 ? 'hour' : 'hours'}`;
}
