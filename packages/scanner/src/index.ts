/**
 * Programmatic entrypoint.
 *
 * The JSON report shape (`ScanReport`) is the stable public interface; this
 * module exposes the same scan the CLI runs, for embedding in other tooling.
 */
export { scan, scanPath } from './api.js';
export type { CommentOnlyMatch, ScanPathOptions, ScanResult } from './api.js';
export { assertScanReport, isScanReport } from './schema.js';
/**
 * Redaction primitives.
 *
 * Exported so that an embedding application can re-apply the exact same
 * credential redaction at its own trust boundary — for example a hosted service
 * that renders a report in a browser — instead of reimplementing it and
 * drifting from the rules the scanner itself uses.
 */
export { redact, sanitizeReportText, toEvidence } from './scanner/redaction.js';
export { InternalScannerError, UsageError } from './types.js';
export type {
  AppsReadiness,
  AutofixSafety,
  Confidence,
  DetectedDependency,
  EffortEstimate,
  EffortItem,
  FileScanResult,
  Finding,
  FindingLevel,
  ReadinessScore,
  RepositoryClassification,
  RuleSource,
  ScanReport,
  ScanIssue,
  ScanIssueCode,
  ScanStatus,
  ScanSummary,
  ScoreDeduction,
  SkipReason,
  TargetStatus,
  TransportType,
} from './types.js';
export {
  SCANNER_VERSION,
  DEFAULT_TARGET_VERSION,
  BASELINE_PROTOCOL_VERSION,
  RC_DISCLAIMER,
} from './constants.js';
/**
 * Discovery inputs.
 *
 * Exported so a host that stages a repository before scanning — unpacking an
 * archive, say — can pre-filter using exactly the same extension list and
 * always-ignored directories the scanner will apply, instead of maintaining a
 * second copy that silently drifts out of step.
 */
export { ALWAYS_IGNORE_PATTERNS, SUPPORTED_EXTENSIONS } from './constants.js';
