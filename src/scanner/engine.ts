import {
  CONFIDENCE_RANK,
  KNOWN_TARGETS,
  LEVEL_RANK,
  SCANNER_VERSION,
} from '../constants.js';
import type {
  Finding,
  FindingLevel,
  PreparedFile,
  ResolvedScanOptions,
  ScanContext,
  ScanReport,
  ScanSummary,
  ScannerRule,
  FileScanResult,
} from '../types.js';
import { InternalScannerError } from '../types.js';
import { classify } from './classification.js';
import { discover } from './discovery.js';
import { estimateEffort } from './effort.js';
import { toEvidence } from './redaction.js';
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
  rules?: ScannerRule[];
  /** Overridable for tests so reports can be compared byte-for-byte. */
  now?: () => Date;
}

export async function runScan(
  options: ResolvedScanOptions,
  engineOptions: EngineOptions = {},
): Promise<ScanResult> {
  const rules = engineOptions.rules ?? ALL_RULES;
  const now = engineOptions.now ?? (() => new Date());

  const target = KNOWN_TARGETS[options.target];
  if (!target) {
    // Guarded by CLI validation; reaching here is a programming error.
    throw new InternalScannerError(`Unknown target specification "${options.target}".`);
  }

  const trace: string[] = [];
  const commentOnlyMatches: CommentOnlyMatch[] = [];

  const { files, skipped } = await discover(options);
  if (options.verbose) {
    trace.push(`Discovered ${files.length} scannable file(s), skipped ${skipped.length}.`);
    for (const file of files) trace.push(`  scan ${file.relPath} (${file.size} bytes, ${file.kind})`);
    for (const skip of skipped) trace.push(`  skip ${skip.relPath} (${skip.reason})`);
  }

  const repository = await classify(files, options);
  if (options.verbose) {
    trace.push(
      `Classified transport as "${repository.transport}"` +
        (repository.transportEvidence.length > 0
          ? ` from: ${repository.transportEvidence.join(', ')}`
          : ' (no transport evidence found)'),
    );
    if (repository.httpRoutingIsAbstracted) {
      trace.push('HTTP routing appears abstracted; header findings will be downgraded to review.');
    }
  }

  const context: ScanContext = {
    target,
    repository,
    files,
    options,
    trace: (message) => {
      if (options.verbose) trace.push(message);
    },
    // Redacted like any other excerpt: this text reaches --verbose output, and
    // a commented-out line can carry a credential just as live code can.
    noteCommentOnlyMatch: (ruleId, file, line, text) => {
      commentOnlyMatches.push({ ruleId, file, line, text: toEvidence(text, 80) });
    },
  };

  const allFindings: Finding[] = [];

  for (const rule of rules) {
    if (!transportApplies(rule, context)) {
      if (options.verbose) {
        trace.push(
          `  rule ${rule.id}: skipped — does not apply to transport "${repository.transport}"`,
        );
      }
      continue;
    }
    if (!files.some((file) => fileApplies(rule, file))) {
      if (options.verbose) trace.push(`  rule ${rule.id}: skipped — no applicable files`);
      continue;
    }

    let produced: Finding[];
    try {
      produced = await rule.scan(context);
    } catch (cause) {
      throw new InternalScannerError(`Rule ${rule.id} failed during scanning.`, cause);
    }

    if (options.verbose) {
      trace.push(`  rule ${rule.id}: ${produced.length} finding(s)`);
    }
    allFindings.push(...produced);
  }

  const filtered = allFindings.filter((finding) => meetsConfidence(finding, options));
  const findings = sortFindings(filtered);

  const summary = buildSummary(context, files, skipped, findings, commentOnlyMatches.length);
  const fileResults = buildFileResults(files, skipped, findings);

  const report: ScanReport = {
    schemaVersion: '1.0',
    scannerVersion: SCANNER_VERSION,
    generatedAt: now().toISOString(),
    target: {
      protocolVersion: target.protocolVersion,
      status: target.status,
      baselineVersion: target.baselineVersion,
    },
    repository,
    summary,
    findings,
    files: fileResults,
  };

  return { report, trace, commentOnlyMatches };
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
      a.category.localeCompare(b.category, 'en') ||
      a.ruleId.localeCompare(b.ruleId, 'en') ||
      a.file.localeCompare(b.file, 'en') ||
      a.line - b.line ||
      (a.column ?? 0) - (b.column ?? 0) ||
      a.title.localeCompare(b.title, 'en'),
  );
}

function buildSummary(
  context: ScanContext,
  files: PreparedFile[],
  skipped: { relPath: string }[],
  findings: Finding[],
  commentOnlyMatches: number,
): ScanSummary {
  const counts: Record<FindingLevel, number> = { error: 0, warning: 0, review: 0, info: 0 };
  const byRule: Record<string, number> = {};

  for (const finding of findings) {
    counts[finding.level] += 1;
    byRule[finding.ruleId] = (byRule[finding.ruleId] ?? 0) + 1;
  }

  const sortedByRule: Record<string, number> = {};
  for (const key of Object.keys(byRule).sort((a, b) => a.localeCompare(b, 'en'))) {
    sortedByRule[key] = byRule[key] as number;
  }

  const filesRequiringChanges = new Set(
    findings.filter((finding) => finding.level !== 'info').map((finding) => finding.file),
  ).size;

  return {
    filesDiscovered: files.length + skipped.length,
    filesScanned: files.length,
    filesSkipped: skipped.length,
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
  skipped: { relPath: string; reason: FileScanResult['skipped']; size?: number }[],
  findings: Finding[],
): FileScanResult[] {
  const countByFile = new Map<string, number>();
  for (const finding of findings) {
    countByFile.set(finding.file, (countByFile.get(finding.file) ?? 0) + 1);
  }

  const results: FileScanResult[] = [
    ...files.map((file) => ({
      file: file.relPath,
      scanned: true,
      size: file.size,
      findingCount: countByFile.get(file.relPath) ?? 0,
    })),
    ...skipped.map((skip) => {
      const result: FileScanResult = {
        file: skip.relPath,
        scanned: false,
        findingCount: 0,
      };
      if (skip.reason) result.skipped = skip.reason;
      if (skip.size !== undefined) result.size = skip.size;
      return result;
    }),
  ];

  return results.sort((a, b) => a.file.localeCompare(b.file, 'en'));
}
