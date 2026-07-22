import type {
  DetectedDependency,
  EffortEstimate,
  EffortItem,
  FileScanResult,
  Finding,
  ReadinessScore,
  RepositoryClassification,
  RuleSource,
  ScanIssue,
  ScanReport,
  ScanSummary,
  ScoreDeduction,
} from './types.js';
import { compareCodeUnits } from './order.js';

type JsonObject = Record<string, unknown>;

const LEVELS = ['error', 'warning', 'review', 'info'] as const;
const CONFIDENCES = ['high', 'medium', 'low'] as const;
const AUTOFIX = ['safe', 'suggested', 'manual', 'none'] as const;
const TRANSPORTS = ['stdio', 'streamable-http', 'mixed', 'custom-http', 'unknown'] as const;
const TARGET_STATUSES = ['release-candidate', 'final', 'draft'] as const;
const APPS_READINESS = [
  'LIKELY_READY',
  'POSSIBLE_CANDIDATE',
  'NO_SIGNAL',
  'NOT_APPLICABLE',
] as const;
const SKIP_REASONS = [
  'ignored',
  'unsupported-extension',
  'too-large',
  'binary',
  'unreadable',
  'test-path',
  'symlink',
  'symlink-outside-root',
  'depth-limit',
  'invalid-utf8',
  'parse-failure',
  'complexity-limit',
  'unreadable-directory',
  'discovery-limit',
  'root-changed',
  'scan-limit',
] as const;
const ISSUE_CODES = [
  ...SKIP_REASONS,
  'finding-limit',
  'report-limit',
  'analysis-limit',
] as const;
const SCAN_STATUSES = ['complete', 'partial'] as const;
const PARTIAL_SKIP_REASONS: ReadonlySet<(typeof SKIP_REASONS)[number]> = new Set([
  'too-large',
  'binary',
  'unreadable',
  'symlink',
  'symlink-outside-root',
  'depth-limit',
  'invalid-utf8',
  'parse-failure',
  'complexity-limit',
  'unreadable-directory',
  'discovery-limit',
  'root-changed',
  'scan-limit',
]);
const PARTIAL_ISSUE_CODES: ReadonlySet<(typeof ISSUE_CODES)[number]> = new Set([
  ...PARTIAL_SKIP_REASONS,
  'finding-limit',
  'report-limit',
  'analysis-limit',
]);

/** Runtime guard for reports received from JSON or another process. */
export function isScanReport(value: unknown): value is ScanReport {
  if (!isObject(value)) return false;
  return (
    value.schemaVersion === '1.0' &&
    nonEmptyString(value.scannerVersion) &&
    isoDate(value.generatedAt) &&
    isTarget(value.target) &&
    member(value.scanStatus, SCAN_STATUSES) &&
    Array.isArray(value.issues) &&
    value.issues.every(isScanIssue) &&
    ((value.scanStatus === 'complete' && value.issues.length === 0) ||
      (value.scanStatus === 'partial' &&
        value.issues.some((issue) => PARTIAL_ISSUE_CODES.has(issue.code)))) &&
    isRepository(value.repository) &&
    isSummary(value.summary) &&
    Array.isArray(value.findings) &&
    value.findings.every(isFinding) &&
    Array.isArray(value.files) &&
    value.files.every(isFileScanResult) &&
    reportInvariantsHold(value as unknown as ScanReport)
  );
}

function isScanIssue(value: unknown): value is ScanIssue {
  return (
    isObject(value) &&
    member(value.code, ISSUE_CODES) &&
    portableRelativePath(value.path, true) &&
    nonEmptyString(value.message) &&
    (value.size === undefined || nonNegativeInteger(value.size)) &&
    (value.count === undefined || nonNegativeInteger(value.count))
  );
}

/** Asserts the stable report contract and narrows `value` to `ScanReport`. */
export function assertScanReport(value: unknown): asserts value is ScanReport {
  if (!isScanReport(value)) {
    throw new TypeError('Value is not a valid mcp-upgrade ScanReport (schemaVersion 1.0).');
  }
}

function isTarget(value: unknown): boolean {
  return (
    isObject(value) &&
    nonEmptyString(value.protocolVersion) &&
    member(value.status, TARGET_STATUSES) &&
    nonEmptyString(value.baselineVersion)
  );
}

function isRepository(value: unknown): value is RepositoryClassification {
  if (!isObject(value) || !isObject(value.languages)) return false;
  return (
    typeof value.root === 'string' &&
    typeof value.singleFile === 'boolean' &&
    typeof value.isLikelyMcpServer === 'boolean' &&
    stringArray(value.mcpEvidence) &&
    nonNegativeInteger(value.languages.typescript) &&
    nonNegativeInteger(value.languages.javascript) &&
    nonNegativeInteger(value.languages.json) &&
    nonNegativeInteger(value.languages.yaml) &&
    member(value.transport, TRANSPORTS) &&
    stringArray(value.transportEvidence) &&
    (value.sdk === null || isDependency(value.sdk)) &&
    Array.isArray(value.relatedDependencies) &&
    value.relatedDependencies.every(isDependency) &&
    stringArray(value.frameworks) &&
    typeof value.httpRoutingIsAbstracted === 'boolean' &&
    (value.packageName === null || typeof value.packageName === 'string')
  );
}

function isDependency(value: unknown): value is DetectedDependency {
  return isObject(value) && nonEmptyString(value.name) && typeof value.range === 'string';
}

function isSummary(value: unknown): value is ScanSummary {
  if (!isObject(value) || !isObject(value.counts) || !isObject(value.byRule)) return false;
  const counts = value.counts;
  const byRule = value.byRule;
  return (
    nonNegativeInteger(value.filesDiscovered) &&
    nonNegativeInteger(value.filesScanned) &&
    nonNegativeInteger(value.filesSkipped) &&
    nonNegativeInteger(value.filesRequiringChanges) &&
    LEVELS.every((level) => nonNegativeInteger(counts[level])) &&
    Object.values(byRule).every(nonNegativeInteger) &&
    isReadiness(value.readiness) &&
    isEffort(value.effort) &&
    member(value.appsReadiness, APPS_READINESS) &&
    nonNegativeInteger(value.commentOnlyMatches)
  );
}

function isReadiness(value: unknown): value is ReadinessScore {
  return (
    isObject(value) &&
    finiteNumber(value.score) &&
    value.score >= 0 &&
    value.score <= 100 &&
    Array.isArray(value.deductions) &&
    value.deductions.every(isDeduction) &&
    typeof value.explanation === 'string' &&
    typeof value.disclaimer === 'string'
  );
}

function isDeduction(value: unknown): value is ScoreDeduction {
  return (
    isObject(value) &&
    nonEmptyString(value.ruleId) &&
    portableRelativePath(value.file) &&
    member(value.level, LEVELS) &&
    member(value.confidence, CONFIDENCES) &&
    finiteNumber(value.points) &&
    value.points >= 0 &&
    typeof value.reason === 'string'
  );
}

function isEffort(value: unknown): value is EffortEstimate {
  return (
    isObject(value) &&
    Array.isArray(value.items) &&
    value.items.every(isEffortItem) &&
    nonNegativeNumber(value.minHours) &&
    nonNegativeNumber(value.maxHours) &&
    value.minHours <= value.maxHours &&
    stringArray(value.excludes)
  );
}

function isEffortItem(value: unknown): value is EffortItem {
  return (
    isObject(value) &&
    nonEmptyString(value.key) &&
    nonEmptyString(value.label) &&
    nonNegativeNumber(value.minHours) &&
    nonNegativeNumber(value.maxHours) &&
    value.minHours <= value.maxHours &&
    stringArray(value.ruleIds) &&
    Array.isArray(value.files) &&
    value.files.every((file) => portableRelativePath(file))
  );
}

function isFinding(value: unknown): value is Finding {
  return (
    isObject(value) &&
    nonEmptyString(value.ruleId) &&
    member(value.level, LEVELS) &&
    member(value.confidence, CONFIDENCES) &&
    nonEmptyString(value.category) &&
    nonEmptyString(value.title) &&
    portableRelativePath(value.file) &&
    positiveInteger(value.line) &&
    optionalPositiveInteger(value.column) &&
    optionalPositiveInteger(value.endLine) &&
    (value.endLine === undefined ||
      (typeof value.endLine === 'number' && value.endLine >= value.line)) &&
    typeof value.evidence === 'string' &&
    typeof value.explanation === 'string' &&
    typeof value.remediation === 'string' &&
    isRuleSource(value.source) &&
    (value.transportApplicability === undefined ||
      typeof value.transportApplicability === 'string') &&
    member(value.autofix, AUTOFIX)
  );
}

function isRuleSource(value: unknown): value is RuleSource {
  return (
    isObject(value) &&
    nonEmptyString(value.title) &&
    officialHttpsSource(value.url) &&
    (value.sep === undefined || nonEmptyString(value.sep))
  );
}

function isFileScanResult(value: unknown): value is FileScanResult {
  if (
    !isObject(value) ||
    typeof value.scanned !== 'boolean' ||
    !portableRelativePath(value.file) ||
    (value.size !== undefined && !nonNegativeInteger(value.size)) ||
    !nonNegativeInteger(value.findingCount)
  ) {
    return false;
  }

  return value.scanned
    ? value.skipped === undefined
    : member(value.skipped, SKIP_REASONS) && value.findingCount === 0;
}

/** Cross-field guarantees relied upon by CLI and hosted report consumers. */
function reportInvariantsHold(report: ScanReport): boolean {
  const { summary, findings, files, issues } = report;
  if (summary.filesScanned + summary.filesSkipped !== summary.filesDiscovered) return false;

  const hasReportLimit = issues.some((issue) => issue.code === 'report-limit');
  if (hasReportLimit) {
    if (files.length > summary.filesDiscovered) return false;
  } else if (files.length !== summary.filesDiscovered) {
    return false;
  }

  const scannedFiles = files.filter((file) => file.scanned).length;
  const skippedFiles = files.length - scannedFiles;
  if (new Set(files.map((file) => file.file)).size !== files.length) return false;
  if (
    (!hasReportLimit &&
      (scannedFiles !== summary.filesScanned || skippedFiles !== summary.filesSkipped)) ||
    (hasReportLimit &&
      (scannedFiles > summary.filesScanned || skippedFiles > summary.filesSkipped))
  ) {
    return false;
  }

  if (!hasReportLimit) {
    const issueKeys = new Set(issues.map((issue) => `${issue.code}\u0000${issue.path}`));
    for (const file of files) {
      if (
        !file.scanned &&
        file.skipped !== undefined &&
        PARTIAL_SKIP_REASONS.has(file.skipped) &&
        !issueKeys.has(`${file.skipped}\u0000${file.file}`)
      ) {
        return false;
      }
    }
  }

  const expectedCounts = Object.fromEntries(LEVELS.map((level) => [level, 0])) as Record<
    (typeof LEVELS)[number],
    number
  >;
  const expectedByRule: Record<string, number> = Object.create(null) as Record<string, number>;
  const findingsByFile = new Map<string, number>();
  const filesRequiringChanges = new Set<string>();
  for (const finding of findings) {
    expectedCounts[finding.level]++;
    expectedByRule[finding.ruleId] = (expectedByRule[finding.ruleId] ?? 0) + 1;
    findingsByFile.set(finding.file, (findingsByFile.get(finding.file) ?? 0) + 1);
    if (finding.level !== 'info') filesRequiringChanges.add(finding.file);
  }

  if (LEVELS.some((level) => summary.counts[level] !== expectedCounts[level])) return false;
  const actualRuleKeys = Object.keys(summary.byRule).sort(compareCodeUnits);
  const expectedRuleKeys = Object.keys(expectedByRule).sort(compareCodeUnits);
  if (
    actualRuleKeys.length !== expectedRuleKeys.length ||
    actualRuleKeys.some(
      (key, index) =>
        key !== expectedRuleKeys[index] || summary.byRule[key] !== expectedByRule[key],
    )
  ) {
    return false;
  }
  if (summary.filesRequiringChanges !== filesRequiringChanges.size) return false;

  const expectedDeductions = new Map<
    string,
    { level: ScoreDeduction['level']; confidence: ScoreDeduction['confidence']; points: number }
  >();
  for (const finding of findings) {
    if (finding.level === 'info') continue;
    const key = `${finding.ruleId}\u0000${finding.file}`;
    const points = readinessPoints(finding.level, finding.confidence);
    const incumbent = expectedDeductions.get(key);
    if (!incumbent || points > incumbent.points) {
      expectedDeductions.set(key, {
        level: finding.level,
        confidence: finding.confidence,
        points,
      });
    }
  }

  if (summary.readiness.deductions.length !== expectedDeductions.size) return false;
  const deductionKeys = new Set<string>();
  let deductedPoints = 0;
  for (const deduction of summary.readiness.deductions) {
    const key = `${deduction.ruleId}\u0000${deduction.file}`;
    if (deductionKeys.has(key)) return false;
    deductionKeys.add(key);
    const expected = expectedDeductions.get(key);
    if (
      !expected ||
      deduction.level !== expected.level ||
      deduction.confidence !== expected.confidence ||
      deduction.points !== expected.points
    ) {
      return false;
    }
    deductedPoints += deduction.points;
  }
  if (summary.readiness.score !== Math.max(0, 100 - deductedPoints)) return false;

  const scannedPaths = new Set(files.filter((file) => file.scanned).map((file) => file.file));
  for (const file of files) {
    const expectedFindingCount = file.scanned ? (findingsByFile.get(file.file) ?? 0) : 0;
    if (file.findingCount !== expectedFindingCount) return false;
  }
  if (!hasReportLimit && findings.some((finding) => !scannedPaths.has(finding.file))) return false;

  const effortMin = roundHundredths(
    summary.effort.items.reduce((total, item) => total + item.minHours, 0),
  );
  const effortMax = roundHundredths(
    summary.effort.items.reduce((total, item) => total + item.maxHours, 0),
  );
  return summary.effort.minHours === effortMin && summary.effort.maxHours === effortMax;
}

function roundHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

function readinessPoints(
  level: ScoreDeduction['level'],
  confidence: ScoreDeduction['confidence'],
): number {
  switch (level) {
    case 'error':
      return confidence === 'high' ? 15 : 10;
    case 'warning':
      return 5;
    case 'review':
      return 3;
    case 'info':
      return 0;
  }
}

/** Report file locations are POSIX, relative, and never traverse upward. */
function portableRelativePath(value: unknown, allowDot = false): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (allowDot && value === '.') return true;
  if (
    value === '.' ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.includes('\\') ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function officialHttpsSource(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.port !== ''
    ) {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'modelcontextprotocol.io' || hostname.endsWith('.modelcontextprotocol.io')) {
      return true;
    }
    if (hostname === 'github.com' || hostname === 'raw.githubusercontent.com') {
      return parsed.pathname.toLowerCase().startsWith('/modelcontextprotocol/');
    }
    return false;
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function member<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonNegativeNumber(value: unknown): value is number {
  return finiteNumber(value) && value >= 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return nonNegativeNumber(value) && Number.isInteger(value);
}

function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && value > 0;
}

function optionalPositiveInteger(value: unknown): boolean {
  return value === undefined || positiveInteger(value);
}

function isoDate(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}
