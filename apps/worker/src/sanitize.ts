/**
 * Report sanitisation — the trust boundary.
 *
 * The scanner produces a report about untrusted source code, on a filesystem
 * path that reveals the worker's internals. This module converts that into
 * something safe to store and render, and then *proves* it by validating the
 * result against the published schema. Anything the schema does not recognise
 * is a failure, not a field to pass through: that is what stops a future
 * scanner field carrying a path into a browser.
 *
 * Redaction is re-applied here even though the scanner already redacts. The two
 * layers use the same implementation (exported by the scanner precisely so they
 * cannot drift), and the second pass covers the fields the scanner treats as
 * its own metadata rather than as evidence.
 */
import { redact, sanitizeReportText } from 'mcp-upgrade';
import type { ScanReport } from 'mcp-upgrade';
import { MAX_REPORT_BYTES, validatePublishedReport } from '@mcp-upgrade/shared';
import type { PublishedReport } from '@mcp-upgrade/shared';
import { IngestionError } from './errors.js';

export interface SanitizeOptions {
  /**
   * What `repository.root` becomes. The user-facing source label — `owner/repo`
   * or the uploaded file name — never a filesystem path.
   */
  sourceLabel: string;
}

/** Caps that bound how much a single hostile repository can make us store. */
const MAX_FINDINGS = 2_000;
const MAX_FILE_RECORDS = 5_000;
const MAX_ISSUES = 1_000;
const MAX_DEDUCTIONS = 2_000;
const MAX_EVIDENCE_STRINGS = 100;

/**
 * Normalises a scanner-produced path to a safe repository-relative POSIX path.
 *
 * The scanner already emits relative POSIX paths, so in practice this is a
 * no-op. It is written as a hard normalisation rather than an assertion because
 * this is the last point at which a path can be corrected, and a report that
 * fails schema validation costs the user their scan.
 */
function safePath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '.';
  let value = raw.replace(/\\/g, '/');
  // Strip a drive letter or leading slashes rather than rejecting: the goal is
  // a usable relative path, and anything absolute has already lost its meaning
  // to the reader.
  value = value.replace(/^[A-Za-z]:/, '');
  value = value.replace(/^\/+/, '');
  const segments = value
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  const joined = segments.join('/');
  if (joined.length === 0) return '.';
  return joined.length > 1024 ? joined.slice(0, 1024) : joined;
}

function safeText(raw: unknown, maxLength: number): string {
  if (typeof raw !== 'string') return '';
  return sanitizeReportText(raw, maxLength);
}

/**
 * Builds the published report.
 *
 * Throws `report_invalid` if the result does not validate. Failing closed is
 * deliberate: a report we cannot prove is safe is not shown at all.
 */
export function sanitizeReport(report: ScanReport, options: SanitizeOptions): PublishedReport {
  const label = safeText(options.sourceLabel, 200) || 'project';

  const findings = report.findings.slice(0, MAX_FINDINGS).map((finding) => ({
    ruleId: safeText(finding.ruleId, 120),
    level: finding.level,
    confidence: finding.confidence,
    category: safeText(finding.category, 120),
    title: safeText(finding.title, 500),
    file: safePath(finding.file),
    line: clampInt(finding.line),
    ...(finding.column === undefined ? {} : { column: clampInt(finding.column) }),
    ...(finding.endLine === undefined ? {} : { endLine: clampInt(finding.endLine) }),
    // Evidence is the one field that is literally attacker-authored source, so
    // it is redacted again here rather than trusted from upstream.
    evidence: safeText(redact(String(finding.evidence ?? '')), 2000),
    explanation: safeText(finding.explanation, 5000),
    remediation: safeText(finding.remediation, 5000),
    source: {
      title: safeText(finding.source?.title, 300),
      url: safeUrl(finding.source?.url),
      ...(finding.source?.sep === undefined ? {} : { sep: safeText(finding.source.sep, 64) }),
    },
    ...(finding.transportApplicability === undefined
      ? {}
      : { transportApplicability: safeText(finding.transportApplicability, 500) }),
    autofix: finding.autofix,
  }));

  const published = {
    schemaVersion: report.schemaVersion,
    scannerVersion: safeText(report.scannerVersion, 64),
    generatedAt: safeText(report.generatedAt, 64),
    target: {
      protocolVersion: safeText(report.target.protocolVersion, 64),
      status: report.target.status,
      baselineVersion: safeText(report.target.baselineVersion, 64),
    },
    scanStatus: report.scanStatus,
    issues: report.issues.slice(0, MAX_ISSUES).map((issue) => ({
      code: safeText(issue.code, 120),
      path: safePath(issue.path),
      message: safeText(issue.message, 2000),
      ...(issue.size === undefined ? {} : { size: clampInt(issue.size) }),
      ...(issue.count === undefined ? {} : { count: clampInt(issue.count) }),
    })),
    repository: {
      // The single most important substitution in this file.
      root: label,
      singleFile: Boolean(report.repository.singleFile),
      isLikelyMcpServer: Boolean(report.repository.isLikelyMcpServer),
      mcpEvidence: report.repository.mcpEvidence
        .slice(0, MAX_EVIDENCE_STRINGS)
        .map((item) => safeText(redact(item), 1000)),
      languages: {
        typescript: clampInt(report.repository.languages.typescript),
        javascript: clampInt(report.repository.languages.javascript),
        json: clampInt(report.repository.languages.json),
        yaml: clampInt(report.repository.languages.yaml),
      },
      transport: report.repository.transport,
      transportEvidence: report.repository.transportEvidence
        .slice(0, MAX_EVIDENCE_STRINGS)
        .map((item) => safeText(redact(item), 1000)),
      sdk: report.repository.sdk
        ? {
            name: safeText(report.repository.sdk.name, 300),
            range: safeText(report.repository.sdk.range, 200),
          }
        : null,
      relatedDependencies: report.repository.relatedDependencies.slice(0, 200).map((dep) => ({
        name: safeText(dep.name, 300),
        range: safeText(dep.range, 200),
      })),
      frameworks: report.repository.frameworks.slice(0, 100).map((item) => safeText(item, 200)),
      httpRoutingIsAbstracted: Boolean(report.repository.httpRoutingIsAbstracted),
      packageName:
        report.repository.packageName === null
          ? null
          : safeText(report.repository.packageName, 300),
    },
    summary: {
      filesDiscovered: clampInt(report.summary.filesDiscovered),
      filesScanned: clampInt(report.summary.filesScanned),
      filesSkipped: clampInt(report.summary.filesSkipped),
      filesRequiringChanges: clampInt(report.summary.filesRequiringChanges),
      counts: {
        error: clampInt(report.summary.counts.error),
        warning: clampInt(report.summary.counts.warning),
        review: clampInt(report.summary.counts.review),
        info: clampInt(report.summary.counts.info),
      },
      byRule: Object.fromEntries(
        Object.entries(report.summary.byRule)
          .slice(0, 500)
          .map(([key, value]) => [safeText(key, 120), clampInt(value)]),
      ),
      readiness: {
        score: clampScore(report.summary.readiness.score),
        deductions: report.summary.readiness.deductions.slice(0, MAX_DEDUCTIONS).map((d) => ({
          ruleId: safeText(d.ruleId, 120),
          file: safePath(d.file),
          level: d.level,
          confidence: d.confidence,
          points: Number.isFinite(d.points) ? d.points : 0,
          reason: safeText(d.reason, 1000),
        })),
        explanation: safeText(report.summary.readiness.explanation, 20000),
        disclaimer: safeText(report.summary.readiness.disclaimer, 2000),
      },
      effort: {
        items: report.summary.effort.items.slice(0, 200).map((item) => ({
          key: safeText(item.key, 120),
          label: safeText(item.label, 300),
          minHours: nonNegative(item.minHours),
          maxHours: nonNegative(item.maxHours),
          ruleIds: item.ruleIds.slice(0, 200).map((id) => safeText(id, 120)),
          files: item.files.slice(0, 2000).map(safePath),
        })),
        minHours: nonNegative(report.summary.effort.minHours),
        maxHours: nonNegative(report.summary.effort.maxHours),
        excludes: report.summary.effort.excludes.slice(0, 100).map((e) => safeText(e, 500)),
      },
      appsReadiness: report.summary.appsReadiness,
      commentOnlyMatches: clampInt(report.summary.commentOnlyMatches),
    },
    findings,
    files: report.files.slice(0, MAX_FILE_RECORDS).map((file) => ({
      file: safePath(file.file),
      scanned: Boolean(file.scanned),
      ...(file.skipped === undefined ? {} : { skipped: safeText(file.skipped, 120) }),
      ...(file.size === undefined ? {} : { size: clampInt(file.size) }),
      findingCount: clampInt(file.findingCount),
    })),
  };

  const validation = validatePublishedReport(published);
  if (!validation.ok) {
    throw new IngestionError('report_invalid', `sanitized report failed validation: ${validation.reason}`);
  }

  // Size is checked on the serialised form, because that is what is stored and
  // what is sent to a browser.
  const serialisedBytes = Buffer.byteLength(JSON.stringify(validation.report), 'utf8');
  if (serialisedBytes > MAX_REPORT_BYTES) {
    throw new IngestionError(
      'report_invalid',
      `sanitized report is ${serialisedBytes} bytes, beyond the cap`,
    );
  }

  return validation.report;
}

function clampInt(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
  return numeric < 0 ? 0 : Math.min(numeric, Number.MAX_SAFE_INTEGER);
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function clampScore(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/**
 * Rule source links come from the scanner's own rule definitions rather than
 * from scanned code, but they are still constrained to https so that a report
 * can never render a `javascript:` or `data:` link.
 */
function safeUrl(raw: unknown): string {
  if (typeof raw !== 'string') return 'https://modelcontextprotocol.io/';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return 'https://modelcontextprotocol.io/';
    return url.toString().slice(0, 2048);
  } catch {
    return 'https://modelcontextprotocol.io/';
  }
}
