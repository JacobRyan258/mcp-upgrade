import {
  CONFIDENCE_RANK,
  KNOWN_TARGETS,
  LEVEL_RANK,
  SCANNER_VERSION,
} from '../constants.js';
import type {
  DetectedDependency,
  Finding,
  FindingLevel,
  RepositoryClassification,
  PreparedFile,
  ResolvedScanOptions,
  ScanContext,
  ScanIssue,
  ScanReport,
  ScanSummary,
  ScannerRule,
  FileScanResult,
  SkipReason,
} from '../types.js';
import { InternalScannerError } from '../types.js';
import { compareCodeUnits } from '../order.js';
import { classify } from './classification.js';
import { discover } from './discovery.js';
import type { DiscoveryInternals, SkippedFile } from './discovery.js';
import { estimateEffort } from './effort.js';
import { sanitizeReportText, toEvidence } from './redaction.js';
import { ALL_RULES, deriveAppsReadiness } from './rules/index.js';
import { fileApplies, transportApplies } from './rules/helpers.js';
import { computeReadiness } from './scoring.js';

export interface CommentOnlyMatch {
  ruleId: string;
  file: string;
  line: number;
  text: string;
}

export interface ScanResult {
  report: ScanReport;
  /** Verbose diagnostics. Empty unless `--verbose` was passed. */
  trace: string[];
  commentOnlyMatches: CommentOnlyMatch[];
}

export interface EngineOptions {
  /** Overridable for tests. Defaults to every registered rule. */
  rules?: readonly ScannerRule[];
  /** Overridable for tests so reports can be compared byte-for-byte. */
  now?: () => Date;
  /** Internal filesystem seams used only by deterministic security tests. */
  discovery?: DiscoveryInternals;
}

const MAX_TRACE_ENTRIES = 2_000;
const MAX_COMMENT_MATCH_DETAILS = 1_000;
const MAX_FINDINGS = 20_000;
const MAX_FILE_RESULTS = 25_000;
const MAX_ISSUE_DETAILS = 5_000;

const PARTIAL_REASONS: ReadonlySet<SkipReason> = new Set([
  'too-large',
  'binary',
  'invalid-utf8',
  'parse-failure',
  'complexity-limit',
  'unreadable',
  'unreadable-directory',
  'symlink',
  'symlink-outside-root',
  'depth-limit',
  'discovery-limit',
  'root-changed',
  'scan-limit',
]);

export async function runScan(
  options: ResolvedScanOptions,
  engineOptions: EngineOptions = {},
): Promise<ScanResult> {
  const rules = [...(engineOptions.rules ?? ALL_RULES)];
  const now = engineOptions.now ?? (() => new Date());

  const knownTarget = KNOWN_TARGETS[options.target];
  if (!knownTarget) {
    // Guarded by CLI validation; reaching here is a programming error.
    throw new InternalScannerError(
      `Unknown target specification "${sanitizeReportText(options.target, 256)}".`,
    );
  }
  const target = Object.freeze({ ...knownTarget });

  const trace: string[] = [];
  const commentOnlyMatches: CommentOnlyMatch[] = [];
  const analysisIssues: ScanIssue[] = [];
  const analysisIssueKeys = new Set<string>();
  let omittedAnalysisIssues = 0;
  let commentOnlyMatchCount = 0;
  let traceTruncated = false;
  const addTrace = (message: string): void => {
    if (!options.verbose || traceTruncated) return;
    if (trace.length >= MAX_TRACE_ENTRIES - 1) {
      trace.push('Trace truncated at the defensive diagnostic limit.');
      traceTruncated = true;
      return;
    }
    trace.push(sanitizeReportText(message, 1_000));
  };

  let discovery: Awaited<ReturnType<typeof discover>>;
  try {
    discovery = await discover(options, engineOptions.discovery);
  } catch (cause) {
    throw new InternalScannerError('File discovery failed.', sanitizeErrorCause(cause));
  }
  const { files, skipped } = discovery;
  if (options.verbose) {
    addTrace(`Discovered ${files.length} scannable file(s), skipped ${skipped.length}.`);
    for (const file of files) {
      addTrace(`  scan ${file.relPath} (${file.size} bytes, ${file.kind})`);
    }
    for (const skip of skipped) addTrace(`  skip ${skip.relPath} (${skip.reason})`);
  }

  let repository: RepositoryClassification;
  try {
    repository = await classify(files, options);
  } catch (cause) {
    throw new InternalScannerError('Repository classification failed.', sanitizeErrorCause(cause));
  }
  if (options.verbose) {
    addTrace(
      `Classified transport as "${repository.transport}"` +
        (repository.transportEvidence.length > 0
          ? ` from: ${repository.transportEvidence.join(', ')}`
          : ' (no transport evidence found)'),
    );
    if (repository.httpRoutingIsAbstracted) {
      addTrace('HTTP routing appears abstracted; header findings will be downgraded to review.');
    }
  }

  const reportPath = createReportPathSanitizer([
    repository.root,
    ...files.map((file) => file.relPath),
    ...skipped.map((skip) => skip.relPath || '.'),
  ]);

  const context: ScanContext = {
    target,
    repository,
    files,
    options,
    trace: (message) => {
      addTrace(message);
    },
    // Redacted like any other excerpt: this text reaches --verbose output, and
    // a commented-out line can carry a credential just as live code can.
    noteCommentOnlyMatch: (ruleId, file, line, text) => {
      commentOnlyMatchCount++;
      if (options.verbose && commentOnlyMatches.length < MAX_COMMENT_MATCH_DETAILS) {
        commentOnlyMatches.push({
          ruleId: sanitizeReportText(ruleId, 128),
          file: reportPath(file),
          line,
          text: toEvidence(text, 80),
        });
      }
    },
    noteAnalysisLimit: (ruleId, file, message) => {
      const publicRuleId = sanitizeReportText(ruleId, 128);
      const publicPath = reportPath(file || '.');
      const publicMessage = `Rule ${publicRuleId}: ${sanitizeReportText(message, 1_000)}`;
      const key = `${publicRuleId}\u0000${publicPath}\u0000${publicMessage}`;
      if (analysisIssueKeys.has(key)) return;
      if (analysisIssues.length >= MAX_ISSUE_DETAILS) {
        omittedAnalysisIssues++;
        return;
      }
      analysisIssueKeys.add(key);
      analysisIssues.push({ code: 'analysis-limit', path: publicPath, message: publicMessage });
    },
  };

  const allFindings: Finding[] = [];
  let findingLimitReached = false;

  for (const rule of rules) {
    if (!transportApplies(rule, context)) {
      if (options.verbose) {
        addTrace(
          `  rule ${rule.id}: skipped — does not apply to transport "${repository.transport}"`,
        );
      }
      continue;
    }
    if (!files.some((file) => fileApplies(rule, file))) {
      if (options.verbose) addTrace(`  rule ${rule.id}: skipped — no applicable files`);
      continue;
    }

    let produced: Finding[];
    try {
      produced = await rule.scan(context);
    } catch (cause) {
      throw new InternalScannerError(
        `Rule ${sanitizeReportText(rule.id, 128)} failed during scanning.`,
        sanitizeErrorCause(cause),
      );
    }

    if (options.verbose) {
      addTrace(`  rule ${rule.id}: ${produced.length} finding(s)`);
    }
    const reportable = produced.filter((finding) => meetsConfidence(finding, options));
    const remaining = MAX_FINDINGS - allFindings.length;
    if (reportable.length > remaining) {
      allFindings.push(...reportable.slice(0, remaining));
      findingLimitReached = true;
      addTrace(`Finding output truncated at ${MAX_FINDINGS} records; remaining rules were skipped.`);
      break;
    }
    allFindings.push(...reportable);
  }

  if (commentOnlyMatchCount > commentOnlyMatches.length) {
    addTrace(
      `Ignored-evidence details truncated: retained ${commentOnlyMatches.length} of ${commentOnlyMatchCount}.`,
    );
  }

  const findings = sortFindings(allFindings.map((finding) => sanitizeFinding(finding, reportPath)));

  const summary = buildSummary(context, files, skipped, findings, commentOnlyMatchCount);
  // Count against the original relative paths. Public-path redaction can map
  // distinct secret-shaped names to the same placeholder, but that must not
  // merge their per-file finding totals.
  const fileResultBuild = buildFileResults(files, skipped, allFindings, reportPath);
  const issueBuild = buildIssues(skipped, reportPath);
  const combinedIssues = [...issueBuild.issues, ...analysisIssues].sort(
    (a, b) => compareCodeUnits(a.path, b.path) || compareCodeUnits(a.code, b.code),
  );
  const baseOmittedReportDetails =
    fileResultBuild.omitted + issueBuild.omitted + omittedAnalysisIssues;
  let reportLimitRequired = baseOmittedReportDetails > 0;
  let detailCapacity =
    MAX_ISSUE_DETAILS - (findingLimitReached ? 1 : 0) - (reportLimitRequired ? 1 : 0);
  let combinedIssueOmitted = Math.max(0, combinedIssues.length - detailCapacity);
  if (combinedIssueOmitted > 0 && !reportLimitRequired) {
    reportLimitRequired = true;
    detailCapacity--;
    combinedIssueOmitted = Math.max(0, combinedIssues.length - detailCapacity);
  }
  const issues = combinedIssues.slice(0, detailCapacity);
  if (findingLimitReached) {
    issues.push({
      code: 'finding-limit',
      path: '.',
      message: 'Finding output reached the defensive limit; later matches or rules may be absent.',
    });
  }
  const omittedReportDetails = baseOmittedReportDetails + combinedIssueOmitted;
  if (reportLimitRequired) {
    issues.push({
      code: 'report-limit',
      path: '.',
      message: 'Per-file or per-issue details were truncated at the defensive report limit.',
      count: omittedReportDetails,
    });
  }
  issues.sort(
    (a, b) => compareCodeUnits(a.path, b.path) || compareCodeUnits(a.code, b.code),
  );
  const publicRepository = sanitizeRepository(repository, reportPath);

  const report: ScanReport = {
    schemaVersion: '1.0',
    scannerVersion: SCANNER_VERSION,
    generatedAt: now().toISOString(),
    target: {
      protocolVersion: target.protocolVersion,
      status: target.status,
      baselineVersion: target.baselineVersion,
    },
    scanStatus: issues.length === 0 ? 'complete' : 'partial',
    issues,
    repository: publicRepository,
    summary,
    findings,
    files: fileResultBuild.results,
  };

  return { report, trace, commentOnlyMatches };
}

function sanitizeErrorCause(cause: unknown): Error | undefined {
  if (!(cause instanceof Error)) return undefined;
  const sanitized = new Error(sanitizeReportText(cause.message, 2_000));
  sanitized.name = sanitizeReportText(cause.name, 128) || 'Error';
  const code = (cause as NodeJS.ErrnoException).code;
  if (typeof code === 'string') {
    (sanitized as NodeJS.ErrnoException).code = sanitizeReportText(code, 128);
  }
  return sanitized;
}

function sanitizeFinding(finding: Finding, reportPath: (raw: string) => string): Finding {
  const sanitized: Finding = {
    ruleId: sanitizeReportText(finding.ruleId, 128),
    level: finding.level,
    confidence: finding.confidence,
    category: sanitizeReportText(finding.category, 128),
    title: sanitizeReportText(finding.title, 512),
    file: reportPath(finding.file),
    line: finding.line,
    evidence: toEvidence(finding.evidence),
    explanation: sanitizeReportText(finding.explanation, 4_096),
    remediation: sanitizeReportText(finding.remediation, 4_096),
    source: {
      title: sanitizeReportText(finding.source.title, 512),
      url: sanitizeReportText(finding.source.url, 2_048),
      ...(finding.source.sep === undefined
        ? {}
        : { sep: sanitizeReportText(finding.source.sep, 128) }),
    },
    autofix: finding.autofix,
  };
  if (finding.column !== undefined) sanitized.column = finding.column;
  if (finding.endLine !== undefined) sanitized.endLine = finding.endLine;
  if (finding.transportApplicability !== undefined) {
    sanitized.transportApplicability = sanitizeReportText(finding.transportApplicability, 512);
  }
  return sanitized;
}

function sanitizeDependency(dependency: DetectedDependency): DetectedDependency {
  return {
    name: sanitizeReportText(dependency.name, 512),
    range: sanitizeReportText(dependency.range, 512),
  };
}

function sanitizeReportPathBase(raw: string): string {
  const source = raw || '.';
  const hasDrivePrefix = /^[A-Za-z]:/.test(source);
  let escaped = '';
  let offset = 0;
  for (const character of source) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '%') escaped += '%25';
    else if (character === '\\') escaped += '%5C';
    else if (hasDrivePrefix && offset === 1 && character === ':') escaped += '%3A';
    else if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      escaped += [...Buffer.from(character, 'utf8')]
        .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
        .join('');
    } else {
      escaped += character;
    }
    offset += character.length;
  }
  const sanitized = sanitizeReportText(escaped, 4_096);
  return sanitized.trim() === '' ? '[sanitized-path]' : sanitized;
}

/**
 * Produces one stable public identity for every discovered path. Redaction and
 * truncation can collapse distinct hostile filenames to the same string, so a
 * collision group receives deterministic, non-secret ordinal suffixes. All
 * report sections share this per-scan map.
 */
function createReportPathSanitizer(rawPaths: readonly string[]): (raw: string) => string {
  const rawValues = [...new Set(rawPaths.map((raw) => raw || '.'))].sort(compareCodeUnits);
  const groups = new Map<string, string[]>();
  for (const raw of rawValues) {
    const base = sanitizeReportPathBase(raw);
    const values = groups.get(base) ?? [];
    values.push(raw);
    groups.set(base, values);
  }

  const reservedBases = new Set(groups.keys());
  const used = new Set<string>();
  const publicByRaw = new Map<string, string>();
  const sortedGroups = [...groups.entries()].sort(([left], [right]) =>
    compareCodeUnits(left, right),
  );

  for (const [base, values] of sortedGroups) {
    if (values.length === 1) {
      publicByRaw.set(values[0] as string, base);
      used.add(base);
      continue;
    }

    let suffix = 1;
    for (const raw of values) {
      let candidate: string;
      do {
        candidate = pathWithCollisionSuffix(base, suffix++);
      } while (reservedBases.has(candidate) || used.has(candidate));
      publicByRaw.set(raw, candidate);
      used.add(candidate);
    }
  }

  return (raw: string): string => {
    const source = raw || '.';
    return publicByRaw.get(source) ?? sanitizeReportPathBase(source);
  };
}

function pathWithCollisionSuffix(value: string, suffix: number): string {
  const slash = value.lastIndexOf('/');
  const dot = value.lastIndexOf('.');
  return dot > slash
    ? `${value.slice(0, dot)}~${suffix}${value.slice(dot)}`
    : `${value}~${suffix}`;
}

function sortedSanitized(values: string[], maxLength: number): string[] {
  return [...new Set(values.map((value) => sanitizeReportText(value, maxLength)))].sort(
    compareCodeUnits,
  );
}

function sanitizeRepository(
  repository: RepositoryClassification,
  reportPath: (raw: string) => string,
): RepositoryClassification {
  return {
    root: reportPath(repository.root),
    singleFile: repository.singleFile,
    isLikelyMcpServer: repository.isLikelyMcpServer,
    mcpEvidence: sortedSanitized(repository.mcpEvidence, 1_024),
    languages: { ...repository.languages },
    transport: repository.transport,
    transportEvidence: sortedSanitized(repository.transportEvidence, 512),
    sdk: repository.sdk ? sanitizeDependency(repository.sdk) : null,
    relatedDependencies: repository.relatedDependencies
      .map(sanitizeDependency)
      .sort(
        (a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.range, b.range),
      ),
    frameworks: sortedSanitized(repository.frameworks, 512),
    httpRoutingIsAbstracted: repository.httpRoutingIsAbstracted,
    packageName:
      repository.packageName === null
        ? null
        : sanitizeReportText(repository.packageName, 512),
  };
}

function buildIssues(
  skipped: SkippedFile[],
  reportPath: (raw: string) => string,
): { issues: ScanIssue[]; omitted: number } {
  const issues: ScanIssue[] = [];
  let omitted = 0;
  for (const skip of skipped) {
    if (!PARTIAL_REASONS.has(skip.reason)) continue;
    if (issues.length >= MAX_ISSUE_DETAILS) {
      omitted++;
      continue;
    }
    const issue: ScanIssue = {
      code: skip.reason,
      path: reportPath(skip.relPath || '.'),
      message: issueMessage(skip.reason),
    };
    if (skip.size !== undefined) issue.size = skip.size;
    issues.push(issue);
  }
  issues.sort(
    (a, b) => compareCodeUnits(a.path, b.path) || compareCodeUnits(a.code, b.code),
  );
  return {
    issues,
    omitted,
  };
}

function issueMessage(reason: SkipReason): string {
  switch (reason) {
    case 'too-large':
      return 'File exceeded the configured source-file size limit.';
    case 'binary':
      return 'File contained a NUL byte and was treated as binary.';
    case 'invalid-utf8':
      return 'File was not valid UTF-8 source text.';
    case 'parse-failure':
      return 'Source contained syntax errors or could not be parsed; the file was not scanned.';
    case 'complexity-limit':
      return 'Source exceeded a defensive syntax-complexity limit and was not parsed.';
    case 'unreadable':
      return 'File could not be opened and read safely.';
    case 'unreadable-directory':
      return 'Directory could not be enumerated.';
    case 'symlink':
      return 'Symbolic link was not followed.';
    case 'symlink-outside-root':
      return 'Path resolved outside the selected scan root and was not read.';
    case 'depth-limit':
      return 'Directory was not traversed beyond the defensive nesting-depth limit.';
    case 'discovery-limit':
      return 'Directory enumeration stopped at the defensive discovery limit.';
    case 'root-changed':
      return 'The scan root changed identity while scanning; affected paths were not read.';
    case 'scan-limit':
      return 'File was not scanned because a configured file-count or byte limit was reached.';
    case 'ignored':
    case 'unsupported-extension':
    case 'test-path':
      return 'File was outside the selected scan scope.';
  }
}

/**
 * `--min-confidence` filters findings, but never INFO findings: those exist to
 * explain a clean result, and silently dropping them would make a passing
 * report look like nothing was checked.
 */
function meetsConfidence(finding: Finding, options: ResolvedScanOptions): boolean {
  if (finding.level === 'info') return true;
  return CONFIDENCE_RANK[finding.confidence] <= CONFIDENCE_RANK[options.minConfidence];
}

/** Total order, so the same repository always produces the same report. */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
      compareCodeUnits(a.category, b.category) ||
      compareCodeUnits(a.ruleId, b.ruleId) ||
      compareCodeUnits(a.file, b.file) ||
      a.line - b.line ||
      (a.column ?? 0) - (b.column ?? 0) ||
      compareCodeUnits(a.title, b.title),
  );
}

function buildSummary(
  context: ScanContext,
  files: PreparedFile[],
  skipped: SkippedFile[],
  findings: Finding[],
  commentOnlyMatches: number,
): ScanSummary {
  const counts: Record<FindingLevel, number> = { error: 0, warning: 0, review: 0, info: 0 };
  const byRule = Object.create(null) as Record<string, number>;

  for (const finding of findings) {
    counts[finding.level] += 1;
    byRule[finding.ruleId] = (byRule[finding.ruleId] ?? 0) + 1;
  }

  const sortedByRule = Object.create(null) as Record<string, number>;
  for (const key of Object.keys(byRule).sort(compareCodeUnits)) {
    sortedByRule[key] = byRule[key] as number;
  }

  const filesRequiringChanges = new Set(
    findings.filter((finding) => finding.level !== 'info').map((finding) => finding.file),
  ).size;
  const skippedFileCount = skipped.filter((entry) => entry.entryType === 'file').length;

  return {
    filesDiscovered: files.length + skippedFileCount,
    filesScanned: files.length,
    filesSkipped: skippedFileCount,
    filesRequiringChanges,
    counts,
    byRule: sortedByRule,
    readiness: computeReadiness(findings),
    effort: estimateEffort(findings),
    appsReadiness: deriveAppsReadiness(context, findings),
    commentOnlyMatches,
  };
}

function buildFileResults(
  files: PreparedFile[],
  skipped: SkippedFile[],
  findings: Finding[],
  reportPath: (raw: string) => string,
): { results: FileScanResult[]; omitted: number } {
  const countByFile = new Map<string, number>();
  for (const finding of findings) {
    countByFile.set(finding.file, (countByFile.get(finding.file) ?? 0) + 1);
  }

  const results: FileScanResult[] = [
    ...files.map((file) => {
      const publicPath = reportPath(file.relPath);
      return {
        file: publicPath,
        scanned: true,
        size: file.size,
        findingCount: countByFile.get(file.relPath) ?? 0,
      };
    }),
    ...skipped.filter((skip) => skip.entryType === 'file').map((skip) => {
      const result: FileScanResult = {
        file: reportPath(skip.relPath),
        scanned: false,
        findingCount: 0,
      };
      if (skip.reason) result.skipped = skip.reason;
      if (skip.size !== undefined) result.size = skip.size;
      return result;
    }),
  ];

  results.sort((a, b) => compareCodeUnits(a.file, b.file));
  return {
    results: results.slice(0, MAX_FILE_RESULTS),
    omitted: Math.max(0, results.length - MAX_FILE_RESULTS),
  };
}
